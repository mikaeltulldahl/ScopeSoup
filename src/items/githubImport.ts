// Importing a project's GitHub Issues once into Items on its meta branch (decision 67). GitHub is only read here: the
// open issues (and closed ones when asked for), their parents and their blockers. Every issue becomes one Item of a single
// batch, written in one meta commit by the person who runs it; links between the imported issues become links between the
// Items. Each Item carries `importedFrom: github:owner/name#N` in its header, so a second run finds it and imports it again
// never. The last comments of each issue (3 by default) come along in the Item's description, marked as imported; anything
// written to GitHub afterwards is `githubMove.ts`, asked for separately.

import type { Client } from "../hosts/github/client.ts";
import { GitHubError } from "../hosts/github/client.ts";
import { readMarker } from "../hosts/github/conventions.ts";
import { issueRefFromUrl, labelNames, splitBody, TODO_LABEL } from "../hosts/github/map.ts";
import type { RestComment, RestIssue, RestUser } from "../hosts/github/rest.ts";
import type { BatchItem } from "../hosts/metaBranch/index.ts";
import type { ItemInput } from "../hosts/metaBranch/serialize.ts";
import type { LineWrite, Writer } from "../hosts/metaBranch/writer.ts";
import { priorityFromLabels } from "../model/priority.ts";
import type { WorkState } from "../model/types.ts";
import { farUntil } from "./service.ts";
import { plural } from "../model/plural.ts";

/** The header key that says where an Item came from. Optional: an older Scope Soup keeps it and ignores it (decision 63). */
export const IMPORTED_FROM = "importedFrom";

/** Which closed issues are imported too: none (the default), the N most recently updated, or all. */
export type ClosedChoice = "none" | "all" | number;

/** How many of each issue's last comments come along by default. */
export const DEFAULT_COMMENTS = 3;

/** One comment as the import reads it: a person's, not Scope Soup's own and not a bot's. */
export interface SourceComment {
  login: string;
  /** When it was written, as GitHub gives it. */
  at: string;
  url: string;
  body: string;
}

/** Another issue, as a link of an imported one: an issue of this repository by number, or one elsewhere by `owner/name#N`. */
export interface IssueLink {
  number?: number;
  other?: string;
  open: boolean;
}

/** One issue as the import reads it. */
export interface SourceIssue {
  number: number;
  title: string;
  body: string;
  open: boolean;
  /** GitHub's `state_reason` of a closed issue (`completed`, `not_planned`, `duplicate`). */
  reason?: string;
  labels: string[];
  assignees: string[];
  url: string;
  parent?: IssueLink;
  blockedBy: IssueLink[];
  /** The last comments asked for, oldest first. */
  comments?: SourceComment[];
  /** How many comments of people the issue has, of which `comments` are the last. */
  commentTotal?: number;
}

/** `owner/name`, as GitHub allows it. */
export const isRepoName = (text: string): boolean => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text) && !text.split("/").some((part) => part === "." || part === "..");

/** The `importedFrom` value of issue `number` of `repo`. Lower case: GitHub's names do not depend on case. */
export const importKey = (repo: string, number: number): string => `github:${repo.toLowerCase()}#${number}`;

const linkTo = (repo: string, url: string | null | undefined, open: boolean): IssueLink | undefined => {
  const ref = issueRefFromUrl({ host: "github", repo }, url);
  if (!ref) return undefined;
  return /^\d+$/.test(ref.id) ? { number: Number(ref.id), open } : { other: ref.id, open };
};

const notThere = (error: unknown): boolean => error instanceof GitHubError && (error.status === 404 || error.status === 410);

/** The issues of a list request (pull requests left out), at least `want` of them when there are that many. */
async function issuesOf(client: Client, query: string, want: number | undefined): Promise<RestIssue[]> {
  // `max` counts pull requests too, which the issues list mixes in: ask for more until enough issues are read.
  for (let max = want; ; max = (max as number) * 2) {
    const got = (await client.list<RestIssue>(client.repoPath(`/issues?${query}`), max === undefined ? {} : { max })).data;
    const issues = got.filter((issue) => !issue.pull_request);
    if (max === undefined || issues.length >= (want as number) || got.length < max) return want === undefined ? issues : issues.slice(0, want);
  }
}

/** A bot's comment, by the account's type or its `[bot]` name. */
const fromBot = (comment: RestComment): boolean => comment.user?.type === "Bot" || /\[bot\]$/i.test(comment.user?.login ?? "");

/** A comment Scope Soup wrote (a question, a claim, a log, the moved-to-Scope Soup note): a marker of its own anywhere in it. */
const fromScopeSoup = (comment: RestComment): boolean => readMarker(comment.body) !== null || /<!-- scopesoup:[a-z]+ /.test(comment.body ?? "");

/** The comments of people on an issue, oldest first: Scope Soup's own, bots' and empty ones left out. */
export function peopleComments(comments: readonly RestComment[], issueUrl: string): SourceComment[] {
  return comments
    .filter((comment) => !fromBot(comment) && !fromScopeSoup(comment) && (comment.body ?? "").trim() !== "")
    .map((comment) => ({ login: comment.user?.login ?? "ghost", at: comment.created_at, url: comment.html_url ?? `${issueUrl}#issuecomment-${comment.id}`, body: comment.body ?? "" }));
}

/**
 * Reads what the import needs from GitHub: the open issues, the closed ones asked for, each one's blockers and its last
 * `comments` comments of people. Read only: nothing here writes to GitHub.
 */
export async function readIssues(client: Client, closed: ClosedChoice = "none", comments: number = DEFAULT_COMMENTS): Promise<SourceIssue[]> {
  const raw = await issuesOf(client, "state=open&sort=created&direction=asc&per_page=100", undefined);
  if (closed !== "none") raw.push(...(await issuesOf(client, "state=closed&sort=updated&direction=desc&per_page=100", closed === "all" ? undefined : closed)));
  const seen = new Set<number>();
  const out: SourceIssue[] = [];
  for (const issue of raw) {
    if (seen.has(issue.number)) continue;
    seen.add(issue.number);
    // The blockers: asked only when GitHub's summary says there are some, or does not say.
    const summary = issue.issue_dependencies_summary;
    let blockers: RestIssue[] = [];
    if (summary?.total_blocked_by === undefined || summary.total_blocked_by > 0) {
      try {
        blockers = (await client.list<RestIssue>(client.repoPath(`/issues/${issue.number}/dependencies/blocked_by?per_page=100`))).data;
      } catch (error) {
        if (!notThere(error)) throw error;
      }
    }
    const parent = linkTo(client.repo, issue.parent_issue_url, true);
    const url = issue.html_url ?? `https://github.com/${client.repo}/issues/${issue.number}`;
    // The comments, read only when some are asked for and GitHub's count does not say there are none.
    let people: SourceComment[] | undefined;
    if (comments > 0 && issue.comments !== 0) {
      try {
        people = peopleComments((await client.list<RestComment>(client.repoPath(`/issues/${issue.number}/comments?per_page=100`))).data, url);
      } catch (error) {
        if (!notThere(error)) throw error;
      }
    }
    out.push({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      open: issue.state === "open",
      ...(issue.state === "closed" && issue.state_reason ? { reason: issue.state_reason } : {}),
      labels: labelNames(issue.labels),
      assignees: (issue.assignees ?? []).map((user) => user.login),
      url,
      ...(parent ? { parent } : {}),
      ...(people && people.length > 0 ? { comments: people.slice(-comments), commentTotal: people.length } : {}),
      blockedBy: blockers.map((blocker) => linkTo(client.repo, blocker.html_url ?? (blocker.repository_url ? `${blocker.repository_url}/issues/${blocker.number}` : undefined), blocker.state === "open")).filter((link): link is IssueLink => link !== undefined),
    });
  }
  return out.sort((a, b) => a.number - b.number);
}

/** The login the token acts as, to know which assignee is the person running the import. Undefined when GitHub does not say. */
export async function tokenLogin(client: Client): Promise<string | undefined> {
  try {
    return (await client.get<RestUser>("/user")).data.login;
  } catch {
    return undefined;
  }
}

// --- the Items ---

// Lone surrogates cannot be stored as UTF-8; control characters other than tab and line ends are refused in a description.
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const oneLine = (text: string): string => text.replace(LONE, "\uFFFD").replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
export const cleanBody = (text: string): string => text.replace(LONE, "\uFFFD").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");

/** A label as the header can hold it: one line, no comma or bracket (the list syntax). */
export const cleanLabel = (label: string): string => oneLine(label.replace(/[,[\]]/g, " "));

/** Labels that mean something on GitHub only: Scope Soup's own conventions there, and `priority:*`, which becomes the priority. */
export const githubOnly = (label: string): boolean => /^priority:/i.test(label.trim()) || /^scopesoup:/i.test(label.trim());

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The text with links to issues of `repo` rewritten: `#12`, `owner/name#12` and the issue's GitHub URL become the Item id
 * when issue 12 is imported. A bare `#12` that is not imported becomes `owner/name#12`, which still means something once the
 * backlog is not on GitHub. A URL that is a markdown link's target or an autolink stays, so the link still opens. Code (fenced
 * blocks and inline spans) is left as it is.
 */
export function rewriteLinks(text: string, repo: string, idOf: (number: number) => string | undefined): string {
  const name = escape(repo);
  const pattern = new RegExp(`(?<!\\]\\(|<)https?://github\\.com/${name}/issues/(\\d+)(?![\\w/#-])|(?<![\\w/.-])${name}#(\\d+)\\b|(?<![\\w/&#])#(\\d+)\\b`, "gi");
  const swap = (part: string): string =>
    part.replace(pattern, (whole, url?: string, full?: string, bare?: string) => {
      const number = Number(url ?? full ?? bare);
      const id = idOf(number);
      if (id) return id;
      return bare !== undefined ? `${repo}#${bare}` : whole;
    });
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      out.push(line);
    } else if (fenced) out.push(line);
    // Inline code spans (odd parts of a split on backtick runs) stay.
    else out.push(line.split(/(`+[^`]*`+)/).map((part, index) => (index % 2 === 1 ? part : swap(part))).join(""));
  }
  return out.join("\n");
}

export interface BatchContext {
  /** `owner/name`, as the person gave it. */
  repo: string;
  /** The person running the import: the author of the lines, and the holder of what is assigned to them on GitHub. */
  person: string;
  /** The person's GitHub login, when known: an open issue assigned to it is held by the person. */
  login?: string;
  now: Date;
}

/** The longest part of one comment that comes along; GitHub allows 65536 characters, and the description holds 1 MB. */
const COMMENT_CHARS = 20_000;

/** `2026-11-22T09:05:00Z` as `2026-11-22 09:05 UTC`; anything else as it is. */
const shortTime = (at: string): string => {
  const time = Date.parse(at);
  return Number.isNaN(time) ? oneLine(at) : `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

/**
 * The comments as a section of the description: who wrote each, when, a link to it, and its text quoted (so its headings
 * and fences stay inside it). Links to imported issues are rewritten as in the body.
 */
export function commentsSection(issue: SourceIssue, repo: string, idOf: (number: number) => string | undefined): string {
  const comments = issue.comments ?? [];
  if (comments.length === 0) return "";
  const total = issue.commentTotal ?? comments.length;
  const parts = ["## Comments imported from GitHub", total > comments.length ? `_The last ${comments.length} of ${total} comments on [${repo}#${issue.number}](${issue.url})._` : `_The comments on [${repo}#${issue.number}](${issue.url})._`];
  for (const comment of comments) {
    let text = cleanBody(comment.body).trim();
    if (text.length > COMMENT_CHARS) text = `${text.slice(0, COMMENT_CHARS).replace(/[\uD800-\uDBFF]$/, "")}\n\n(cut here: the rest is on GitHub)`;
    const quoted = rewriteLinks(text, repo, idOf).split("\n").map((line) => (line.trim() === "" ? ">" : `> ${line}`)).join("\n");
    parts.push(`**@${oneLine(comment.login)}** wrote on ${shortTime(comment.at)} ([link](${oneLine(comment.url)})):\n\n${quoted}`);
  }
  return parts.join("\n\n");
}

const stateOf = (issue: SourceIssue): WorkState => (issue.open ? "todo" : issue.reason === "not_planned" || issue.reason === "duplicate" ? "abandoned" : "done");

/** The batch to write: one Item per issue, keyed by the issue number, found again by `importedFrom`. Pure. */
export function importBatch(issues: readonly SourceIssue[], context: BatchContext): BatchItem[] {
  const { repo } = context;
  const imported = new Set(issues.map((issue) => issue.number));
  const by = { who: context.person, agent: false };
  const where = (link: IssueLink): string => link.other ?? `${repo}#${link.number}`;
  return issues.map((issue): BatchItem => ({
    key: String(issue.number),
    unique: [IMPORTED_FROM, importKey(repo, issue.number)],
    make(idOf) {
      const id = (number: number | undefined): string | undefined => (number !== undefined && imported.has(number) ? idOf(String(number)) : undefined);
      const parent = issue.parent ? id(issue.parent.number) : undefined;
      const blockedBy = [...new Set(issue.blockedBy.map((link) => id(link.number)).filter((each): each is string => each !== undefined))];
      const labels = [...new Set(issue.labels.filter((label) => !githubOnly(label)).map(cleanLabel).filter((label) => label !== ""))];
      const priority = priorityFromLabels(issue.labels);
      const mine = issue.open && context.login !== undefined && issue.assignees.some((login) => login.toLowerCase() === context.login?.toLowerCase());

      // A Verification section of one line becomes the header field; a longer one stays in the description.
      let body = cleanBody(issue.body);
      const split = splitBody(body);
      const verification = split.verification !== undefined && !split.verification.includes("\n") ? oneLine(split.verification) : undefined;
      if (verification) body = split.description;
      body = rewriteLinks(body, repo, id).trim();

      const notes = [`Imported from GitHub: [${repo}#${issue.number}](${issue.url}).`];
      const others = issue.assignees.filter((login) => !(mine && login.toLowerCase() === context.login?.toLowerCase()));
      if (others.length > 0) notes.push(`Assigned there to ${others.map((login) => `@${login}`).join(", ")}.`);
      if (issue.parent && !parent) notes.push(`A sub-issue there of ${where(issue.parent)}, which was not imported.`);
      const away = issue.blockedBy.filter((link) => link.open && !id(link.number)).map(where);
      if (away.length > 0) notes.push(`Blocked there by ${away.join(", ")}, not imported.`);
      const footer = `_${notes.join(" ")}_`;
      const discussion = commentsSection(issue, repo, id);

      const lines: LineWrite[] = [{ kind: "created", by }];
      if (mine) lines.push({ kind: "claimed", by, fields: { until: farUntil(context.now) } });
      return {
        input: {
          title: oneLine(issue.title) || `Issue ${issue.number}`,
          state: stateOf(issue),
          // In Backlog on GitHub (no `scopesoup:todo` label, decision 120): in Backlog here too.
          ...(issue.open && !issue.labels.some((label) => label.toLowerCase() === TODO_LABEL) ? { lane: "backlog" as const } : {}),
          labels,
          ...(parent ? { parent } : {}),
          blockedBy,
          ...(verification ? { verification } : {}),
          ...(priority ? { priority } : {}),
          body: [body, discussion, footer].filter((part) => part !== "").join("\n\n"),
        },
        lines,
      };
    },
  }));
}

// --- the run ---

export interface ImportOptions {
  client: Client;
  writer: Writer;
  repo: string;
  person: string;
  /** The person's GitHub login; read from the token's user when not given. */
  login?: string;
  closed?: ClosedChoice;
  /** How many of each issue's last comments come along (default 3); 0 for none. */
  comments?: number;
  /** Print what would be imported; write nothing. */
  dryRun?: boolean;
  now: Date;
}

export interface ImportRow {
  number: number;
  id: string;
  /** False: an Item imported this issue before, and nothing was written for it. */
  created: boolean;
  state: WorkState;
  title: string;
  held: boolean;
  /** Whether the issue is open on GitHub, and its labels there (for the step on GitHub afterwards). */
  open: boolean;
  githubLabels: string[];
  /** The comments that came along (0 for an issue imported before). */
  comments: number;
}

export interface ImportReport {
  rows: ImportRow[];
  /** The meta commit made; absent on a dry run or when there was nothing new. */
  commit?: string;
  /** Whether the commit is on the remote, and why not. Absent on a dry run. */
  shared?: string;
  problem?: string;
  login?: string;
}

/** Reads the issues, and writes the new ones as one batch (or only plans it, on a dry run). Never writes to GitHub. */
export async function importIssues(options: ImportOptions): Promise<ImportReport> {
  const issues = await readIssues(options.client, options.closed ?? "none", options.comments ?? DEFAULT_COMMENTS);
  const login = options.login ?? (await tokenLogin(options.client));
  const batch = importBatch(issues, { repo: options.repo, person: options.person, now: options.now, ...(login ? { login } : {}) });
  const made = new Map<string, { input: ItemInput; lines?: LineWrite[] }>();
  // The batch's items as they were made, for the report (the writer calls `make` once per new item on its last try).
  const watched = batch.map((item): BatchItem => ({ ...item, make: (idOf) => {
    const result = item.make(idOf);
    made.set(item.key, result);
    return result;
  } }));
  const title = `Import ${issues.length} issue${issues.length === 1 ? "" : "s"} from GitHub ${options.repo}`;
  const done = await options.writer.createItems(watched, { message: title, ...(options.dryRun ? { dryRun: true } : {}) });
  const rows: ImportRow[] = issues.map((issue) => {
    const item = done.items.get(String(issue.number)) as { id: string; created: boolean };
    const input = made.get(String(issue.number))?.input;
    return {
      number: issue.number, id: item.id, created: item.created, state: input?.state ?? stateOf(issue), title: input?.title ?? oneLine(issue.title),
      held: (made.get(String(issue.number))?.lines ?? []).some((line) => line.kind === "claimed"),
      open: issue.open, githubLabels: issue.labels, comments: item.created ? (issue.comments?.length ?? 0) : 0,
    };
  });
  const report: ImportReport = { rows, ...(login ? { login } : {}) };
  if (!options.dryRun && done.changed && done.commit) report.commit = done.commit;
  if (done.sharing) {
    report.shared = done.sharing.state;
    if (done.sharing.problem) report.problem = done.sharing.problem;
  }
  return report;
}

/** The report as lines for the terminal. */
export function reportText(report: ImportReport, repo: string, dryRun: boolean): string[] {
  const fresh = report.rows.filter((row) => row.created);
  const before = report.rows.filter((row) => !row.created);
  const lines: string[] = [];
  if (report.rows.length === 0) return [`There are no issues to import from ${repo}.`];
  for (const row of report.rows) {
    const what = row.created ? (dryRun ? "would be" : "imported as") : "already";
    lines.push([`#${row.number}`.padEnd(7), what.padEnd(12), row.id.padEnd(8), row.state.padEnd(10), row.held ? "held by you " : "", row.title].join(" ").replace(/\s+$/, ""));
  }
  const summary = dryRun
    ? `Dry run: ${fresh.length} of ${plural(report.rows.length, "issue")} from ${repo} would be imported${before.length > 0 ? `; ${before.length} were imported before` : ""}. Nothing was written.`
    : fresh.length === 0
      ? `Nothing new to import from ${repo}: all ${plural(report.rows.length, "issue")} were imported before.`
      : `Imported ${plural(fresh.length, "issue")} from ${repo} in one meta commit${report.commit ? ` (${report.commit.slice(0, 9)})` : ""}${before.length > 0 ? `; ${before.length} were imported before` : ""}. GitHub was not changed.`;
  lines.push(summary);
  if (!report.login) lines.push("Note: GitHub did not say whose token this is, so no issue is held by you; assignees are named in each Item's text.");
  if (!dryRun && fresh.length > 0 && report.shared === "pending") lines.push(`Not shared with the remote yet${report.problem ? ` (${report.problem})` : ""}; it goes with the next round.`);
  return lines;
}
